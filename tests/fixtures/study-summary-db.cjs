// Import-time guard for pure studySummary fixtures; no pool or connection is created.
exports.ApiError = class ApiError extends Error {};
exports.transaction = () => { throw new Error('Pure summary fixture cannot access a database'); };
