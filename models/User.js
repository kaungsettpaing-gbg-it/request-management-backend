const mongoose = require('mongoose');
const { hashPassword, BCRYPT_HASH_PATTERN } = require('../lib/user-password');

const userSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    maxlength: 254,
    match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  },
  password: { type: String, required: true, select: false },
  name: { type: String, trim: true, maxlength: 120, default: null },
  department: { type: String, trim: true, maxlength: 120, default: null },
  role: { type: String, required: true, default: 'STAFF', maxlength: 40 },
  telegramId: { type: String, trim: true, lowercase: true, maxlength: 64, default: null },
  otp: { type: String, select: false, default: null },
  otpExpiry: { type: Date, select: false, default: null },
  createdAt: { type: Date, required: true, default: Date.now }
}, {
  timestamps: false,
  versionKey: false,
  toJSON: {
    transform(_doc, ret) {
      delete ret._id;
      delete ret.__v;
      delete ret.password;
      delete ret.otp;
      delete ret.otpExpiry;
      return ret;
    }
  }
});

userSchema.index(
  { telegramId: 1 },
  { unique: true, partialFilterExpression: { telegramId: { $type: 'string' } } }
);

userSchema.pre('save', async function hashModifiedPassword() {
  if (this.isModified('password') && !BCRYPT_HASH_PATTERN.test(this.password)) {
    this.password = await hashPassword(this.password);
  }
});

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
