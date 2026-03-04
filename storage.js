const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const User = require('../models/User');
const File = require('../models/File');
const multer = require('multer');
const AWS = require('aws-sdk');

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

    // 1. Check if the user is the OWNER
    const owned = requestingUser.workspacesCreated.id(driveId);
    if (owned) return requestingUser;

    // 2. Check if the user is a GUEST who has joined this Workspace ID
    const isJoined = requestingUser.workspacesJoined.includes(driveId);
    if (isJoined) {
        // Locate the owner of this specific workspace folder
        const owner = await User.findOne({ "workspacesCreated._id": driveId });
        if (!owner) throw { status: 404, msg: "Workspace no longer exists." };
        return owner;
    }

    throw { status: 403, msg: "Unauthorized: You do not have access to this folder." };
}

router.post('/upload', [auth, upload.single('file')], async (req, res) => {
    if (!req.file) return res.status(400).json({ msg: "No file provided" });
    const driveId = req.query.drive || 'personal';

    try {
        const targetOwner = await getTargetDrive(req);
        
        // Determine the S3 folder path based on workspace name
        let folderPath = 'personal';
        if (driveId !== 'personal') {
            const workspace = targetOwner.workspacesCreated.id(driveId);
            folderPath = workspace ? workspace.name : 'UnknownWorkspace';
        }

        const s3Key = `${targetOwner.email}/${folderPath}/${Date.now()}-${req.file.originalname}`;

        const s3Result = await s3.upload({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: s3Key,
            Body: req.file.buffer,
            ContentType: req.file.mimetype
        }).promise();

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
        targetOwner.storageUsed += req.file.size;
        await targetOwner.save();
        res.json({ msg: "Uploaded!", file: newFile });
    } catch (err) { res.status(500).send('Server Error'); }
});

router.get('/files', auth, async (req, res) => {
    const driveId = req.query.drive || 'personal';
    try {
        const targetOwner = await getTargetDrive(req);
        const filter = {
            owner: targetOwner._id,
            workspaceId: driveId === 'personal' ? null : driveId // FILTER BY CONTEXT
        };
        const files = await File.find(filter).populate('uploadedBy', 'username').sort({ date: -1 });
        res.json(files);
    } catch (err) { res.status(500).send('Server Error'); }
});

router.delete('/files/:id', auth, async (req, res) => {
    try {
        const file = await File.findById(req.params.id);
        const canDelete = (file.owner.toString() === req.user.id) || (file.uploadedBy.toString() === req.user.id);
        if (!canDelete) return res.status(403).json({ msg: "Unauthorized." });

        await s3.deleteObject({ Bucket: process.env.AWS_BUCKET_NAME, Key: file.s3Key }).promise();
        await File.findByIdAndDelete(req.params.id);

        const targetOwner = await User.findById(file.owner);
        // FIX: Prevent negative storage
        targetOwner.storageUsed = Math.max(0, targetOwner.storageUsed - file.fileSize);
        await targetOwner.save();

        res.json({ msg: "Deleted" });
    } catch (err) { res.status(500).send('Server Error'); }
});

router.get('/download/:id', auth, async (req, res) => {
    try {
        const file = await File.findById(req.params.id);
        if (!file) return res.status(404).json({ msg: "File not found" });

        const params = {
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: file.s3Key
        };

        const fileStream = s3.getObject(params).createReadStream();

        res.attachment(file.fileName);
        fileStream.pipe(res);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

module.exports = router;