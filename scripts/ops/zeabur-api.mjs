import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
export async function platformQuery(query, variables = {}) {
 const token = process.env.ZEABUR_TOKEN || (await readFile(homedir() + '/.config/zeabur/cli.yaml', 'utf8')).match(/^token:\s*["']?([^\s"']+)/m)?.[1];
 if (!token) throw Error('Zeabur credentials unavailable');
 const response = await fetch('https://api.zeabur.com/graphql', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30000) });
 if (!response.ok) throw Error('Zeabur HTTP ' + response.status);
 const result = await response.json();
 if (result.errors) throw Error('Zeabur API rejected operation');
 return result.data;
}
