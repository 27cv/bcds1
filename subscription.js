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
        
        if (user.package === 'Basic') {
            return res.status(403).json({ msg: "Upgrade required to create workspaces." });
        }

        // FIX: Prevent duplicate names that "replace" old folders
        const nameExists = user.workspacesCreated.some(ws => ws.name.toLowerCase() === name.trim().toLowerCase());
        if (nameExists) {
            return res.status(400).json({ msg: "A workspace with this name already exists." });
        }
    
        // Create folder in S3
        await s3.putObject({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: `${user.email}/${name.trim()}/`
        }).promise();

        user.workspacesCreated.push({
            name: name.trim(),
            allocatedBytes: (parseInt(allocateGB) || 1) * 1024 * 1024 * 1024
        });

        await user.save();

        // FIX: Logging now works without crashing
        await new Activity({
            userId: req.user.id,
            type: 'WORKSPACE_CREATED',
            details: `Created workspace "${name.trim()}"`
        }).save();

        res.json({ msg: "Workspace Created Successfully!" });
    } catch (err) { 
        res.status(400).json({ msg: err.message }); 
    }
});

// @route   POST /api/subscription/share
router.post('/share', auth, async (req, res) => {
    const { emailToShare, workspaceId } = req.body;
    try {
        // 1. Fetch the current user (the inviter)
        const user = await User.findById(req.user.id);
        
        // 2. Define the invitee email first
        const inviteeEmail = emailToShare.toLowerCase().trim();

        // 3. NOW you can check if they are the same
        if (inviteeEmail === user.email.toLowerCase()) {
            return res.status(400).json({ 
                msg: "You cannot invite yourself to your own workspace." 
            });
        }

        // 4. Check for existing pending invites
        const existingInvite = await Invitation.findOne({
            inviteeEmail,
            workspaceId,
            status: 'pending'
        });

        if (existingInvite) {
            return res.status(400).json({ msg: "A pending invitation already exists for this user." });
        }

        // 5. Save the new invitation
        const newInvite = new Invitation({
            inviter: req.user.id,
            inviteeEmail,
            workspaceId
        });
        
        await newInvite.save();
        res.json({ msg: "Invite sent successfully!" });

    } catch (err) { 
        console.error("Invite Error:", err);
        res.status(500).send('Server Error'); 
    }
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


// routes/subscription.js

// routes/subscription.js

router.delete('/workspaces/:id', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        const workspace = user.workspacesCreated.id(req.params.id);

        if (!workspace) {
            return res.status(404).json({ msg: "Workspace not found" });
        }

        const wsName = workspace.name;

        // 1. Identify files to reclaim storage
        const filesInWorkspace = await FileModel.find({ 
            owner: user._id, 
            workspaceId: req.params.id 
        });
        const totalReclaimedBytes = filesInWorkspace.reduce((acc, file) => acc + file.fileSize, 0);

        // 2. AWS S3: Purge the folder
        try {
            const folderPath = `${user.email}/${wsName}/`;
            const listedObjects = await s3.listObjectsV2({
                Bucket: process.env.AWS_BUCKET_NAME,
                Prefix: folderPath
            }).promise();

            if (listedObjects.Contents && listedObjects.Contents.length > 0) {
                await s3.deleteObjects({
                    Bucket: process.env.AWS_BUCKET_NAME,
                    Delete: { Objects: listedObjects.Contents.map(obj => ({ Key: obj.Key })) }
                }).promise();
            }
        } catch (s3Err) {
            console.warn("S3 Cleanup skipped (folder might be empty)");
        }

        // 3. Database Updates
        await FileModel.deleteMany({ owner: user._id, workspaceId: req.params.id });
        user.workspacesCreated.pull({ _id: req.params.id });
        user.storageUsed = Math.max(0, user.storageUsed - totalReclaimedBytes);
        await user.save();

        // 4. ADD DELETE LOG: Ensure this is inside a try/catch to prevent "False Fails"
        try {
            await new Activity({
                userId: req.user.id,
                type: 'WORKSPACE_DELETED',
                details: `Deleted workspace "${wsName}"`
            }).save();
        } catch (logErr) {
            console.error("Activity logging failed, but data was deleted.");
        }

        // 5. Send success response to frontend to stop the "Failed to delete" alert
        return res.status(200).json({ msg: "Workspace purged successfully!" });

    } catch (err) {
        console.error("CRITICAL DELETE ERROR:", err);
        return res.status(500).json({ msg: "Server error during deletion" });
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
    const { plan } = req.body; 
    const prices = { 
        'Premium': 'price_1T7A06GpYkDBDjPdPOFenoj4', 
        'Enterprise': 'price_1T7A0LGpYkDBDjPdUxdXFBUu' 
    };

    const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{ price: prices[plan], quantity: 1 }],
        mode: 'subscription',
        // FIX: Send the plan name so the webhook can read it
        metadata: {
            planName: plan 
        },
        success_url: 'http://localhost:5500/dashboard.html?success=true',
        cancel_url: 'http://localhost:5500/dashboard.html?canceled=true',
        client_reference_id: req.user.id
    });

    res.json({ id: session.id });
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

// @route   POST /api/subscription/leave-workspace/:id
router.post('/leave-workspace/:id', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        
        // Find the workspace name for the log before removing access
        const owner = await User.findOne({ "workspacesCreated._id": req.params.id });
        const workspace = owner ? owner.workspacesCreated.id(req.params.id) : null;
        const wsName = workspace ? workspace.name : "Shared Workspace";

        if (!user.workspacesJoined.includes(req.params.id)) {
            return res.status(400).json({ msg: "You are not a member of this workspace." });
        }

        // Remove workspace from user's joined list
        user.workspacesJoined.pull(req.params.id);
        await user.save();

        // STEP 2: Safe Logging (Prevents server crash if Activity has issues)
        try {
            await new Activity({
                userId: req.user.id,
                type: 'LEAVE_WORKSPACE',
                details: `Left workspace "${wsName}"`
            }).save();
        } catch (logErr) {
            // This message appears in your terminal if logging fails, but the user still leaves
            console.log("Activity logging failed, but data was deleted."); 
        }

        // STEP 3: Always send a JSON response to stop the "Network Error" popup
        return res.status(200).json({ msg: `Successfully left "${wsName}"` });

    } catch (err) {
        console.error("LEAVE ERROR:", err);
        res.status(500).json({ msg: "Server Error" });
    }
});

module.exports = router;