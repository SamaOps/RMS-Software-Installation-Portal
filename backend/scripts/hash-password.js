// Usage: npm run hash-password -- <username> <password>
// Prints an ADMIN_USERS entry. Combine several with commas.
import 'dotenv/config';
import bcrypt from 'bcryptjs';
const COST = Number(process.env.BCRYPT_COST || 12);
const MIN_LEN = Number(process.env.ADMIN_PASSWORD_MIN_LENGTH || 10);
const [user, pass] = process.argv.slice(2);
if (!user || !pass) {
  console.error('Usage: npm run hash-password -- <username> <password>');
  process.exit(1);
}
if (pass.length < MIN_LEN) {
  console.error(`Use a password of at least ${MIN_LEN} characters.`);
  process.exit(1);
}
console.log(`${user}:${bcrypt.hashSync(pass, COST)}`);
