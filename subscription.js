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
                { userId: req.user.id }
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
                user: "You"
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
// @route   POST /api/subscription/workspaces
router.post('/workspaces', auth, async (req, res) => {
    const { name, allocateGB } = req.body;
    try {
        const user = await User.findById(req.user.id);

        if (user.package === 'Basic') {
            return res.status(403).json({ msg: "Upgrade required to create workspaces." });
        }

        const requestedBytes = (parseInt(allocateGB) || 1) * 1024 * 1024 * 1024;

        // --- NEW QUOTA CALCULATION ---
        // Sum up bytes already allocated to other workspaces
        const alreadyAllocated = user.workspacesCreated.reduce((acc, ws) => acc + ws.allocatedBytes, 0);
        const remainingQuota = user.storageLimit - alreadyAllocated;

        if (requestedBytes > remainingQuota) {
            const remainingGB = (remainingQuota / (1024 * 1024 * 1024)).toFixed(2);
            return res.status(400).json({
                msg: `Insufficient quota. You only have ${remainingGB} GB remaining.`
            });
        }

        // --- UNIQUE NAME CHECK ---
        const workspaceName = name.trim();
        if (user.workspacesCreated.some(ws => ws.name.toLowerCase() === workspaceName.toLowerCase())) {
            return res.status(400).json({ msg: `Workspace "${workspaceName}" already exists.` });
        }

        // AWS S3: Create unique folder
        await s3.putObject({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: `${user.email}/${workspaceName}/`
        }).promise();

        // Database: Save workspace details
        user.workspacesCreated.push({
            name: workspaceName,
            allocatedBytes: requestedBytes
        });

        await user.save();

        // Activity Log
        await new Activity({
            userId: req.user.id,
            type: 'WORKSPACE_CREATED',
            details: `Created workspace "${workspaceName}" with ${allocateGB}GB`
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

// @route POST /api/subscription/accept-invite/:id
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

        // --- UPDATED: SYNC TO BLOCKCHAIN WITH TIMEOUT ---
        try {
            const { ethers } = require('ethers');
            const fs = require('fs');

            const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "http://127.0.0.1:7545");
            // Check connection first
            await provider.getNetwork();

            const wallet = new ethers.Wallet(process.env.SERVER_PRIVATE_KEY, provider);
            const contractABI = JSON.parse(fs.readFileSync('./contractABI.json', 'utf8'));
            const aclContract = new ethers.Contract(process.env.CONTRACT_ADDRESS, contractABI, wallet);

            console.log("🔗 Connecting to Blockchain...");
            const tx = await aclContract.grantAccess(invite.workspaceId.toString(), req.user.id.toString());
            // Wait for 1 confirmation
            await tx.wait(1);
            console.log(`✅ Blockchain ACL Updated`);

        } catch (chainErr) {
            console.error("🛑 BLOCKCHAIN SYNC FAILED:", chainErr.message);
            // Optional: Tell the user it worked in DB but blockchain is pending
            return res.status(500).json({ msg: "Blockchain connection error. Please ensure Ganache is running." });
        }
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



// @route   DELETE /api/subscription/workspaces/:id
router.delete('/workspaces/:id', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        const workspace = user.workspacesCreated.id(req.params.id);

        if (!workspace) {
            return res.status(404).json({ msg: "Workspace record not found in your account." });
        }

        const wsName = workspace.name;
        const wsIdString = req.params.id.toString();

        // --- NEW: STEP 0 - BLOCKCHAIN CLEANUP ---
        // We revoke the owner's permission on-chain before deleting the data
        try {
            const { ethers } = require('ethers');
            const fs = require('fs');
            const path = require('path');

            const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "http://127.0.0.1:7545");
            const wallet = new ethers.Wallet(process.env.SERVER_PRIVATE_KEY.trim(), provider);
            const contractABI = JSON.parse(fs.readFileSync(path.join(__dirname, '../contractABI.json'), 'utf8'));
            const aclContract = new ethers.Contract(process.env.CONTRACT_ADDRESS, contractABI, wallet);

            console.log(`⛓️ Revoking Blockchain Access for deletion: Workspace ${wsIdString}`);
            
            // Revoke the owner's access on the ledger
            const tx = await aclContract.revokeAccess(wsIdString, req.user.id.toString());
            await tx.wait(); 
            
            console.log("✅ Blockchain ACL Cleaned.");
        } catch (chainErr) {
            console.error("🛑 Blockchain Revoke Failed during deletion:", chainErr.message);
            // We continue with deletion even if blockchain fails so the user can reclaim quota
        }

        // 1. AWS S3: Clean up the cloud folder
        try {
            const folderPath = `${user.email}/${wsName}/`;
            const objects = await s3.listObjectsV2({ Bucket: process.env.AWS_BUCKET_NAME, Prefix: folderPath }).promise();

            if (objects && objects.Contents.length > 0) {
                await s3.deleteObjects({
                    Bucket: process.env.AWS_BUCKET_NAME,
                    Delete: { Objects: objects.Contents.map(o => ({ Key: o.Key })) }
                }).promise();
            }
        } catch (s3Err) {
            console.warn("S3 folder already empty or missing.");
        }

        // 2. Database: Reclaim the quota and remove the workspace
        user.workspacesCreated.pull({ _id: req.params.id });
        await user.save();

        // 3. Global Cleanup: Remove access for anyone you invited
        await User.updateMany(
            { workspacesJoined: req.params.id },
            { $pull: { workspacesJoined: req.params.id } }
        );

        // Activity Log
        await new Activity({
            userId: req.user.id,
            type: 'WORKSPACE_DELETED',
            details: `"${wsName}"`
        }).save();

        res.json({ msg: "Workspace deleted, S3 cleaned, and quota reclaimed!" });
    } catch (err) {
        console.error("DELETE ERROR:", err);
        res.status(500).json({ msg: "Server error during workspace removal." });
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

    // NEW: Capture the exact origin domain the user is currently on
    const domainUrl = req.headers.origin || 'http://localhost:5500';

    const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{ price: prices[plan], quantity: 1 }],
        mode: 'subscription',
        metadata: {
            planName: plan
        },
        // NEW: Dynamically return them to the correct origin
        success_url: `${domainUrl}/dashboard.html?success=true`,
        cancel_url: `${domainUrl}/dashboard.html?canceled=true`,
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
        const owner = await User.findOne({ "workspacesCreated._id": req.params.id });
        const workspace = owner ? owner.workspacesCreated.id(req.params.id) : null;
        const wsName = workspace ? workspace.name : "Shared Workspace";

        if (!user.workspacesJoined.includes(req.params.id)) {
            return res.status(400).json({ msg: "You are not a member of this workspace." });
        }

        // --- NEW: STEP 1.5 - REVOKE BLOCKCHAIN ACCESS ---
        try {
            const { ethers } = require('ethers');
            const fs = require('fs');
            const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "http://127.0.0.1:7545");
            const wallet = new ethers.Wallet(process.env.SERVER_PRIVATE_KEY, provider);
            const contractABI = JSON.parse(fs.readFileSync('./contractABI.json', 'utf8'));
            const aclContract = new ethers.Contract(process.env.CONTRACT_ADDRESS, contractABI, wallet);

            console.log(`⛓️ Revoking Blockchain Access: User ${req.user.id} from Workspace ${req.params.id}`);

            // Call the Smart Contract function
            const tx = await aclContract.revokeAccess(req.params.id.toString(), req.user.id.toString());
            await tx.wait();

            console.log("✅ Blockchain ACL Revoked.");
        } catch (chainErr) {
            console.error("Blockchain Revoke Failed:", chainErr.message);
            // We continue so the user isn't stuck in a workspace they want to leave
        }

        // Remove workspace from user's joined list (MongoDB)
        user.workspacesJoined.pull(req.params.id);
        await user.save();

        // Activity Logging
        try {
            await new Activity({
                userId: req.user.id,
                type: 'LEAVE_WORKSPACE',
                details: `"${wsName}"`
            }).save();
        } catch (logErr) {
            console.log("Activity logging failed.");
        }

        return res.status(200).json({ msg: `Successfully left "${wsName}" and revoked on-chain permissions.` });

    } catch (err) {
        console.error("LEAVE ERROR:", err);
        res.status(500).json({ msg: "Server Error" });
    }
});

module.exports = router;