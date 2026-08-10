# Coding Cube

## The demo is the product

The website is public. The cloud behind it is not, and it fails closed on purpose. So most
people who ever open <https://codingcube.codyh.xyz> will never hold a pairing code, and the
first ten seconds are the entire product to them.

**The first-run experience is priority one. It outranks every operator convenience.** A
change that makes the cube easier to operate and worse to arrive at is a change that
regressed the thing most people will ever see.

Rules that follow, and that a change may not quietly break:

1. **A stranger never sees an error.** No red state, no "Needs attention", no AWS, no
   Cloudflare, no runtime ARN, no acronym they did not ask about. If a surface can only be
   explained to somebody who deployed this, it must not appear to somebody who did not.

2. **Never ask a question whose answer is already known.** An unpaired browser calling the
   cloud gets a guaranteed 401 — making the call and then reporting the failure converts a
   fact into an alarm. `connectHost()` checks for a pairing code before it reaches for the
   cloud; anything new that reaches for a private resource does the same.

3. **The cube always works.** Six real, typeable shells run in the page itself
   (`local-shell.js`) with no server, no install and no network. Nothing may take that
   away — not a failed connect, not missing config, not an exception on boot. If a change
   can leave the cube dead on arrival, it is the wrong change.

4. **Failures degrade, they do not interrupt.** An operator's problem belongs in Computers,
   where an operator will go looking for it. It does not belong over the cube.

5. **Words are chosen for whoever is reading them.** "No computer attached" is a fault
   report, and it is the wrong sentence for somebody who never attached one. Decide who is
   reading before writing the copy.

### How to check

Open the site in a private window — a browser that has never been here. If anything is red,
if anything is named after a cloud vendor, or if the cube cannot be spun and typed into,
that is a bug, and it outranks whatever else was in flight.
