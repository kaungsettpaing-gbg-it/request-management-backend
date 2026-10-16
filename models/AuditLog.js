const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  action: { type: String, required: true, maxlength: 80 },
  remarks: { type: String, default: null, maxlength: 4000 },
  userId: { type: Number, required: true, index: true },
  requestId: { type: Number, required: true, index: true },
  createdAt: { type: Date, required: true, default: Date.now }
}, {
  timestamps: false,
  versionKey: false,
  toJSON: {
    transform(_doc, ret) {
      delete ret._id;
      delete ret.__v;
      return ret;
    }
  }
});

module.exports = mongoose.models.AuditLog || mongoose.model('AuditLog', auditLogSchema);
