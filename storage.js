const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const User = require('../models/User');
const File = require('../models/File');
const Activity = require('../models/Activity'); // FIX: Added missing import
const multer = require('multer');
const AWS = require('aws-sdk');
const { logToBlockchain } = require('./blockchain'); // Add this near your imports
const { ethers } = require('ethers');
const fs = require('fs');

// Connect to Ganache
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:7545";
const provider = new ethers.JsonRpcProvider(RPC_URL);
// For reading data, we don't even need a private key!
const contractABI = JSON.parse(fs.readFileSync('./contractABI.json', 'utf8'));
const aclContract = new ethers.Contract(process.env.CONTRACT_ADDRESS, contractABI, provider);

const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION
});
const upload = multer({ storage: multer.memoryStorage() });

async function getTargetDrive(req) {
    const driveId = req.query.drive || 'personal';
    const requestingUser = await User.findById(req.user.id);

    if (driveId === 'personal') return requestingUser;

    // Check if the user owns the workspace
    const owned = requestingUser.workspacesCreated.id(driveId);
    if (owned) return requestingUser;

    // Check if the user has joined the workspace
    const isJoined = requestingUser.workspacesJoined.includes(driveId);
    if (isJoined) {
        // We need to find the user who actually owns this workspace ID
        const owner = await User.findOne({ "workspacesCreated._id": driveId });
        if (!owner) throw { status: 404, msg: "Workspace no longer exists." };
        return owner;
    }

    throw { status: 403, msg: "Unauthorized: Access denied by system." };
}

// routes/storage.js

router.post('/upload', [auth, upload.single('file')], async (req, res) => {
    if (!req.file) return res.status(400).json({ msg: "No file provided" });
    const driveId = req.query.drive || 'personal';

    try {
        // 1. Fetch targetOwner FIRST to avoid ReferenceErrors
        const targetOwner = await getTargetDrive(req);

        // 2. CHECK STORAGE LIMITS
        if (targetOwner.storageUsed + req.file.size > targetOwner.storageLimit) {
            return res.status(400).json({ msg: "Upload failed: Not enough storage space." });
        }

        // 3. Determine Folder Path & Location Name
        let folderPath = 'personal';
        let locationName = "Personal Drive";

        if (driveId !== 'personal') {
            const workspace = targetOwner.workspacesCreated.id(driveId);
            folderPath = workspace ? workspace.name : 'UnknownWorkspace';
            locationName = workspace ? `workspace "${workspace.name}"` : "a shared workspace";
        }

        // 4. AWS S3 Upload
        const s3Key = `${targetOwner.email}/${folderPath}/${Date.now()}-${req.file.originalname}`;
        const s3Result = await s3.upload({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: s3Key,
            Body: req.file.buffer,
            ContentType: req.file.mimetype
        }).promise();

        // 5. Save File record to MongoDB
        const newFile = new File({
            owner: targetOwner._id,
            uploadedBy: req.user.id,
            workspaceId: driveId === 'personal' ? null : driveId,
            fileName: req.file.originalname,
            fileSize: req.file.size,
            s3Url: s3Result.Location,
            s3Key: s3Result.Key
        });

        await newFile.save();

        // ---> NEW: 5.5 LOG TO BLOCKCHAIN <---
        try {
            await logToBlockchain(newFile._id.toString());
            console.log(`⛓️ Block mined successfully for file: ${newFile.fileName}`);
        } catch (chainErr) {
            console.error("Blockchain logging failed:", chainErr.message);
            // We log the error but don't stop the upload process
        }

        // 6. Update Owner Storage Usage
        targetOwner.storageUsed += req.file.size;
        await targetOwner.save();

        // 7. SAFE LOGGING: Use try/catch so logging errors don't crash the upload
        try {
            await new Activity({
                userId: req.user.id,
                type: 'FILE_UPLOADED',
                details: `Uploaded "${req.file.originalname}" to ${locationName}`
            }).save();
        } catch (logErr) {
            console.error("Activity logging failed, but file was uploaded successfully.");
        }

        // 8. Success Response
        return res.status(200).json({ msg: "Uploaded!", file: newFile });

    } catch (err) {
        console.error("UPLOAD ERROR:", err);
        return res.status(500).json({ msg: err.message || "Server Error during upload" });
    }
});

router.get('/files', auth, async (req, res) => {
    const driveId = req.query.drive || 'personal';
    try {
        const targetOwner = await getTargetDrive(req);
        const filter = {
            owner: targetOwner._id,
            workspaceId: driveId === 'personal' ? null : driveId
        };
        const files = await File.find(filter).populate('uploadedBy', 'username').sort({ date: -1 });
        res.json(files);
    } catch (err) { res.status(500).send('Server Error'); }
});

router.delete('/files/:id', auth, async (req, res) => {
    try {
        // 1. Fetch the file first so we can check permissions
        const file = await File.findById(req.params.id);
        if (!file) return res.status(404).json({ msg: "File not found" });

        // 2. Fetch the owner of the storage (Personal or Workspace)
        const targetOwner = await User.findById(file.owner);

        // 3. Define the permission variables after fetching the data
        const isWorkspaceOwner = targetOwner._id.toString() === req.user.id;
        const isFileUploader = file.uploadedBy.toString() === req.user.id;

        // 4. Check if the user has the right to delete
        if (!isWorkspaceOwner && !isFileUploader) {
            return res.status(403).json({ msg: "Unauthorized: Only the workspace owner or the uploader can delete this file." });
        }

        // 5. Perform the AWS S3 deletion
        await s3.deleteObject({ Bucket: process.env.AWS_BUCKET_NAME, Key: file.s3Key }).promise();

        // 6. Delete the record from MongoDB
        await File.findByIdAndDelete(req.params.id);

        // 7. Reclaim storage space for the owner
        targetOwner.storageUsed = Math.max(0, targetOwner.storageUsed - file.fileSize);
        await targetOwner.save();

        // 8. Log the activity 
        if (typeof Activity !== 'undefined') {
            try {
                // Define variables BEFORE creating the new Activity object
                const workspace = file.workspaceId ? targetOwner.workspacesCreated.id(file.workspaceId) : null;
                const location = workspace ? `from workspace "${workspace.name}"` : 'from personal drive';

                await new Activity({
                    userId: req.user.id,
                    type: 'FILE_DELETED',
                    details: `Deleted "${file.fileName}" ${location}`
                }).save();
            } catch (logErr) {
                console.error("Activity logging failed:", logErr);
            }
        }

        res.json({ msg: "File deleted and storage updated" });
    } catch (err) {
        console.error("Delete Error:", err);
        res.status(500).json({ msg: "Server Error: Could not delete file." });
    }
});

router.get('/download/:id', auth, async (req, res) => {
    try {
        const file = await File.findById(req.params.id);
        if (!file) return res.status(404).json({ msg: "File not found" });

        // --- BLOCKCHAIN ACCESS CONTROL ENFORCEMENT ---
        if (file.workspaceId) {
            console.log(`Checking Blockchain: Workspace ${file.workspaceId} | User ${req.user.id}`);
            
            // 1. Get status from Smart Contract
            const hasAccess = await aclContract.checkAccess(
                file.workspaceId.toString(), 
                req.user.id.toString()
            );

            // 2. Check if user is the Owner (Owners bypass ACL usually)
            const isOwner = file.owner.toString() === req.user.id.toString();

            if (!isOwner && !hasAccess) {
                console.log("❌ Blockchain Denied Access.");
                return res.status(403).json({ 
                    msg: "Blockchain ACL Denied: Access revoked or not granted on-chain." 
                });
            }
            console.log("✅ Blockchain Granted Access.");
        }

        // --- AWS S3 STREAMING ---
        const params = {
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: file.s3Key
        };

        const fileStream = s3.getObject(params).createReadStream();
        
        fileStream.on('error', (err) => {
            console.error("S3 Stream Error:", err);
            res.status(404).json({ msg: "File not found in S3" });
        });

        res.attachment(file.fileName);
        fileStream.pipe(res);

    } catch (err) {
        console.error("Download Error:", err);
        res.status(500).send('Server Error');
    }
});

module.exports = router;