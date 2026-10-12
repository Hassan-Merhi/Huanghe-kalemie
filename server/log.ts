export function log(message: string, extra?: Record<string, unknown>) {
  const time = new Date().toISOString();
  if (extra) console.log(`${time} ${message}`, JSON.stringify(extra));
  else console.log(`${time} ${message}`);
}
