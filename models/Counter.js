const mongoose = require('mongoose');

const counterSchema = new mongoose.Schema({
  _id: { type: String },
  sequence: { type: Number, required: true, default: 0 }
}, {
  versionKey: false
});

module.exports = mongoose.models.Counter || mongoose.model('Counter', counterSchema);
