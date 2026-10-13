import { execFile } from 'node:child_process';

const PATH = [
  `${process.env.HOME}/.local/bin`,
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  `${process.env.HOME}/.nvm/versions/node/${process.version}/bin`,
  process.env.PATH,
].join(':');

export const env = { ...process.env, PATH };

/** Run a command, resolve stdout. Rejects with stderr in the message. */
export function sh(cmd, args, { cwd, input, timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { cwd, env, timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${cmd} ${args.slice(0, 3).join(' ')}… failed: ${(stderr || err.message).trim().slice(0, 500)}`;
        return reject(err);
      }
      resolve(stdout);
    });
    if (input != null) child.stdin.end(input);
  });
}

export const gh = (args, opts) => sh('gh', args, opts);
export const git = (cwd, args, opts) => sh('git', args, { ...opts, cwd });

export async function ghGraphql(query, vars = {}) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  return JSON.parse(await gh(args)).data;
}
