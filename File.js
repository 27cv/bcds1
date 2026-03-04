const mongoose = require('mongoose');

const FileSchema = new mongoose.Schema({
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
    // ref: 'user' is what allows the system to swap the ID for a username
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true }, 
    workspaceId: { type: String, default: null }, 
    fileName: { type: String, required: true },
    fileSize: { type: Number, required: true },
    s3Url: { type: String, required: true },
    s3Key: { type: String, required: true },
    date: { type: Date, default: Date.now }
});

module.exports = mongoose.model('file', FileSchema);