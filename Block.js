// models/Block.js
const mongoose = require('mongoose');

const BlockSchema = new mongoose.Schema({
    index: { type: Number, required: true },
    timestamp: { type: String, required: true },
    fileId: { type: String, required: true },
    fileHash: { type: String, required: true },
    prevHash: { type: String, required: true },
    hash: { type: String, required: true },
    ethTxHash: { type: String, default: "Pending" }
});

module.exports = mongoose.model('block', BlockSchema);