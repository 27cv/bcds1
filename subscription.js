const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const User = require('../models/User');
const FileModel = require('../models/File'); // Renamed to avoid TypeError
const Invitation = require('../models/Invitation');
const Activity = require('../models/Activity');
const AWS = require('aws-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION
});

// @route   GET /api/subscription/status
router.get('/status', auth, async (req, res) => {
    
    try {
        const user = await User.findById(req.user.id);
        const userEmail = user.email.toLowerCase().trim();

        // 1. Fetch Shared Workspaces
        const sharedOwners = await User.find({
            "workspacesCreated._id": { $in: user.workspacesJoined }
        }, 'username workspacesCreated');

        const sharedWorkspaces = [];
        sharedOwners.forEach(owner => {
            owner.workspacesCreated.forEach(folder => {
                if (user.workspacesJoined.includes(folder._id.toString())) {
                    sharedWorkspaces.push({
                        _id: folder._id,
                        name: folder.name,
                        username: owner.username 
                    });
                }
            });
        });

        // 2. Fetch Pending Invitations
        const [inboxRaw, pendingSent] = await Promise.all([
            Invitation.find({ inviteeEmail: userEmail, status: 'pending' })
                .populate('inviter', 'username workspacesCreated'),
            Invitation.find({ inviter: req.user.id, status: 'pending' })
        ]);

        const inbox = inboxRaw.map(inv => ({
            ...inv._doc,
            workspaceName: inv.inviter.workspacesCreated.id(inv.workspaceId)?.name || "Shared Drive"
        }));

        // 3. FETCH PERSISTENT ACTIVITY FEED
        // This pulls from the Activity collection to ensure 28 vs 27 is correct
        // 2. UPDATED LOGIC: Pull logs for user OR actions in their owned workspaces
        const activityFeedRaw = await Activity.find({ 
            $or: [
                { userId: req.user.id },
                { details: { $regex: user.username, $options: 'i' } } 
            ] 
        })
            .sort({ date: -1 })
            .limit(10);

        const activityFeed = activityFeedRaw.map(act => {
            let displayUser = user.username;
            
            // If the activity is an invite YOU accepted, you are the actor.
            if (act.type === 'INVITE_ACCEPTED') {
                displayUser = user.username; 
            }

            return {
                type: act.type,
                name: act.details,
                date: act.date,
                user: displayUser
            };
        });

        res.json({
            package: user.package, 
            limit: user.storageLimit, 
            used: user.storageUsed,
            userEmail: user.email, 
            username: user.username,
            subscriptionEnd: user.subscriptionEnd, // Send expiry date to frontend
            workspaces: sharedWorkspaces, 
            workspacesCreated: user.workspacesCreated, 
            inbox,
            pendingSentInvites: pendingSent,
            activityFeed 
        });
    } catch (err) { res.status(500).send('Server Error'); }
});

// --- UPDATED WORKSPACE CREATION WITH LOGGING ---
router.post('/workspaces', auth, async (req, res) => {
    const { name, allocateGB } = req.body;
    try {
        const user = await User.findById(req.user.id);
        
        // 3. RESTRICTION: Check if user is on Basic plan
        if (user.package === 'Basic') {
            return res.status(403).json({ 
                msg: "Basic users cannot create workspaces. Please upgrade your plan." 
            });
        }
    
        await s3.putObject({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: `${user.email}/${name.trim()}/`
        }).promise();

        user.workspacesCreated.push({
            name: name.trim(),
            allocatedBytes: (parseInt(allocateGB) || 1) * 1024 * 1024 * 1024
        });

        await user.save();

        // PERSISTENT LOG
        await new Activity({
            userId: req.user.id,
            type: 'WORKSPACE_CREATED',
            details: `Created workspace "${name}"`
        }).save();

        res.json({ msg: "Workspace Created!" });
    } catch (err) { res.status(400).json({ msg: err.message }); }
});

// @route   POST /api/subscription/share
router.post('/share', auth, async (req, res) => {
    const { emailToShare, workspaceId } = req.body;
    try {
        const inviteeEmail = emailToShare.toLowerCase().trim();

        // Check for existing pending invite to prevent duplication
        const existingInvite = await Invitation.findOne({
            inviteeEmail,
            workspaceId,
            status: 'pending'
        });

        if (existingInvite) {
            return res.status(400).json({ msg: "A pending invitation already exists for this user." });
        }

        const newInvite = new Invitation({
            inviter: req.user.id,
            inviteeEmail,
            workspaceId
        });
        await newInvite.save();
        res.json({ msg: "Invite sent successfully!" });
    } catch (err) { res.status(500).send('Server Error'); }
});

// @route   POST /api/subscription/accept-invite/:id
router.post('/accept-invite/:id', auth, async (req, res) => {
    try {
        const invite = await Invitation.findById(req.params.id);
        const invitee = await User.findById(req.user.id);
        const inviter = await User.findById(invite.inviter);
        const workspace = inviter.workspacesCreated.id(invite.workspaceId);

        if (!invitee.workspacesJoined.includes(invite.workspaceId)) {
            invitee.workspacesJoined.push(invite.workspaceId);
        }
        if (!inviter.sharedUsers.includes(invitee.email)) {
            inviter.sharedUsers.push(invitee.email);
        }

        invite.status = 'accepted';
        await invite.save(); await invitee.save(); await inviter.save();

        // PERSISTENT LOG FOR JOINING
        await new Activity({
            userId: req.user.id,
            type: 'INVITE_ACCEPTED',
            details: `Joined workspace "${workspace ? workspace.name : 'Shared Drive'}"`
        }).save();

        res.json({ msg: "Joined successfully!" });
    } catch (err) { res.status(500).send('Server Error'); }
});

// subscription.js - Updated DELETE /workspaces/:id

router.delete('/workspaces/:id', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        const workspace = user.workspacesCreated.id(req.params.id);

        if (!workspace) return res.status(404).json({ msg: "Workspace not found" });

        // 1. Find all files associated with this specific workspace ID
        const filesInWorkspace = await FileModel.find({ 
            owner: user._id, 
            workspaceId: req.params.id 
        });
        
        // 2. Calculate the exact total bytes to deduct
        const totalReclaimedBytes = filesInWorkspace.reduce((acc, file) => acc + file.fileSize, 0);

        // 3. AWS S3: Delete the entire folder and its contents
        const folderPath = `${user.email}/${workspace.name}/`;
        const listedObjects = await s3.listObjectsV2({
            Bucket: process.env.AWS_BUCKET_NAME,
            Prefix: folderPath
        }).promise();

        if (listedObjects.Contents.length > 0) {
            const deleteParams = {
                Bucket: process.env.AWS_BUCKET_NAME,
                Delete: { Objects: listedObjects.Contents.map(obj => ({ Key: obj.Key })) }
            };
            await s3.deleteObjects(deleteParams).promise();
        }

        // 4. Database: Wipe file records, pull workspace, and fix storageUsed
        await FileModel.deleteMany({ owner: user._id, workspaceId: req.params.id });
        user.workspacesCreated.pull({ _id: req.params.id });
        
        // Ensure storageUsed never goes below 0 due to rounding or logic errors
        user.storageUsed = Math.max(0, user.storageUsed - totalReclaimedBytes);
        await user.save();

        // 5. Activity Log: Persistent record of the deletion
        await new Activity({
            userId: req.user.id,
            type: 'INVITE_DECLINED', // Or add WORKSPACE_DELETED to your Enum
            details: `Deleted workspace "${workspace.name}" and reclaimed ${ (totalReclaimedBytes / 1024 / 1024).toFixed(2) } MB`
        }).save();

        res.json({ msg: "Workspace purged and storage reclaimed!" });
    } catch (err) {
        res.status(500).send('Server Error');
    }
});

// @route   DELETE /api/subscription/revoke-invite/:id
router.delete('/revoke-invite/:id', auth, async (req, res) => {
    try {
        const invite = await Invitation.findById(req.params.id);

        if (!invite) return res.status(404).json({ msg: "Invitation not found." });

        // Ensure only the person who sent the invite can revoke it
        if (invite.inviter.toString() !== req.user.id) {
            return res.status(401).json({ msg: "Unauthorized: You did not send this invite." });
        }

        // Only allow revoking if it hasn't been accepted yet
        if (invite.status !== 'pending') {
            return res.status(400).json({ msg: "Cannot revoke an invite that is already accepted or declined." });
        }

        await Invitation.findByIdAndDelete(req.params.id);
        res.json({ msg: "Invitation revoked successfully." });
    } catch (err) { res.status(500).send('Server Error'); }
});

// @route   DELETE /api/subscription/reject-invite/:id
router.post('/reject-invite/:id', auth, async (req, res) => {
    try {
        const invite = await Invitation.findById(req.params.id);
        if (!invite) return res.status(404).json({ msg: "Invitation not found." });

        // Ensure the person rejecting is the intended invitee
        const user = await User.findById(req.user.id);
        if (invite.inviteeEmail !== user.email.toLowerCase()) {
            return res.status(401).json({ msg: "Unauthorized" });
        }

        invite.status = 'declined'; // Or simply delete it
        await invite.save();
        // Option: await Invitation.findByIdAndDelete(req.params.id); 

        res.json({ msg: "Invitation declined." });
    } catch (err) { res.status(500).send('Server Error'); }
});

// @route   POST /api/subscription/create-checkout
router.post('/create-checkout', auth, async (req, res) => {
    const { plan } = req.body; // 'Premium' or 'Enterprise'
    const prices = { 
        'Premium': 'price_1T7A06GpYkDBDjPdPOFenoj4', 
        'Enterprise': 'price_1T7A0LGpYkDBDjPdUxdXFBUu' 
    };

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{ price: prices[plan], quantity: 1 }],
            mode: 'subscription',
            // FIX: Add metadata so the webhook knows the plan name
            metadata: {
                planName: plan 
            },
            // FIX: Use an absolute path or dashboard path that handles sessions correctly
            success_url: 'http://localhost:5500/dashboard.html?session_id={CHECKOUT_SESSION_ID}',
            cancel_url: 'http://localhost:5500/dashboard.html',
            client_reference_id: req.user.id
        });

        res.json({ id: session.id });
    } catch (err) {
        res.status(500).json({ msg: "Stripe Session Error" });
    }
});

// @route   POST /api/subscription/customer-portal
router.post('/customer-portal', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);

        if (!user.stripeCustomerId) {
            return res.status(400).json({ msg: "No active subscription found." });
        }

        // Create a portal session
        const session = await stripe.billingPortal.sessions.create({
            customer: user.stripeCustomerId,
            return_url: 'http://localhost:5500/dashboard.html',
        });

        res.json({ url: session.url });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

module.exports = router;