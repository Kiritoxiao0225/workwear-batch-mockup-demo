// Loaded before an integration test: any request the test did not mock fails at once, so nothing paid is ever called and a slow network cannot stall it.
globalThis.fetch = async () => { throw new Error('integration tests forbid network requests'); };
