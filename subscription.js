const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const User = require('../models/User');
const FileModel = require('../models/File'); // Renamed to avoid TypeError
const Invitation = require('../models/Invitation');
const Activity = require('../models/Activity');
const AWS = require('aws-sdk');

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
        const activityFeedRaw = await Activity.find({ userId: req.user.id })
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

// @route   DELETE /api/subscription/workspaces/:id
router.delete('/workspaces/:id', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        const workspace = user.workspacesCreated.id(req.params.id);

        if (!workspace) return res.status(404).json({ msg: "Workspace not found" });

        const folderPath = `${user.email}/${workspace.name}/`;

        // 1. AWS: List all objects in the workspace folder
        const listedObjects = await s3.listObjectsV2({
            Bucket: process.env.AWS_BUCKET_NAME,
            Prefix: folderPath
        }).promise();

        // 2. AWS: Delete all objects found in that folder
        if (listedObjects.Contents.length > 0) {
            const deleteParams = {
                Bucket: process.env.AWS_BUCKET_NAME,
                Delete: { Objects: listedObjects.Contents.map(obj => ({ Key: obj.Key })) }
            };
            await s3.deleteObjects(deleteParams).promise();
        }

        // 3. Database: Remove file records and the workspace itself
        await FileModel.deleteMany({ owner: user._id, workspaceId: req.params.id });
        user.workspacesCreated.pull({ _id: req.params.id });
        await user.save();

        res.json({ msg: "Workspace and AWS folder purged successfully" });
    } catch (err) {
        console.error(err);
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

module.exports = router;