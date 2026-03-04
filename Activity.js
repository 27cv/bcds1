const mongoose = require('mongoose');

const ActivitySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
    type: { 
        type: String, 
        enum: ['WORKSPACE_CREATED', 'FILE_UPLOADED', 'FILE_DELETED', 'PLAN_UPGRADED', 'PAYMENT_SUCCESS', 'INVITE_SENT', 'INVITE_ACCEPTED', 'INVITE_DECLINED', 'LEAVE_WORKSPACE','WORKSPACE_DELETED'],
        required: true 
    },
    details: { type: String },
    date: { type: Date, default: Date.now }
});

module.exports = mongoose.model('activity', ActivitySchema);