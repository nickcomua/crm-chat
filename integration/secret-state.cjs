// Reports whether one environment variable is non-empty.
// Prints "present" or "absent". Never prints the value.
const key = process.argv[2]
if (!/^[A-Z0-9_]+$/.test(key || '')) {
  process.stderr.write('login-test-account: refused an unexpected secret name\n')
  process.exit(2)
}
process.stdout.write(process.env[key] ? 'present' : 'absent')
