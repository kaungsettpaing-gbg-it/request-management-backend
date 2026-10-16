const mongoose = require('mongoose');

const requestSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  title: { type: String, required: true, trim: true, maxlength: 300 },
  description: { type: String, default: null, maxlength: 20000 },
  category: { type: String, default: 'General', maxlength: 120 },
  status: { type: String, default: 'PENDING', index: true },
  targetDepartment: { type: String, default: 'General', maxlength: 120 },
  approvalStage: { type: String, default: 'ORIGIN_MGR', index: true },
  extraFields: { type: String, default: null, maxlength: 50000 },
  attachment: { type: String, default: null },
  userId: { type: Number, required: true, index: true },
  createdAt: { type: Date, required: true, default: Date.now },
  updatedAt: { type: Date, required: true, default: Date.now }
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

module.exports = mongoose.models.Request || mongoose.model('Request', requestSchema);
