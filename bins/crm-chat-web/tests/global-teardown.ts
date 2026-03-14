export default async function globalTeardown(): Promise<void> {
  // Teardown is handled per-worker by the workerBackend fixture.
  // Nothing to clean up globally.
}
