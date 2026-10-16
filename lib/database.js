const mongoose = require('mongoose');

async function connectDatabase(uri) {
  if (!uri) {
    throw new Error('MONGODB_URI is required to connect to the application database.');
  }

  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);
  return mongoose.connection;
}

module.exports = { connectDatabase };
