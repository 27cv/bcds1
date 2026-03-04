const mongoose = require('mongoose');

const InvitationSchema = new mongoose.Schema({
    inviter: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
    inviteeEmail: { type: String, required: true },
    // NEW: Link the invitation to a specific workspace ID
    workspaceId: { type: mongoose.Schema.Types.ObjectId, required: true },
    status: { type: String, enum: ['pending', 'accepted', 'declined'], default: 'pending' },
    date: { type: Date, default: Date.now }
});

module.exports = mongoose.model('invitation', InvitationSchema);