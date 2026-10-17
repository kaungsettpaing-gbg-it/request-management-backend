function assertPostgresDatabaseUrl(databaseUrl) {
  if (typeof databaseUrl !== 'string' ||
      !/^postgres(?:ql)?:\/\//i.test(databaseUrl.trim())) {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL beginning with postgresql:// or postgres://. Configure it in the deployment environment.');
  }
}

module.exports = { assertPostgresDatabaseUrl };
