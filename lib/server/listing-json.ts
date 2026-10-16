/**
 * A model's JSON answer. Asked for a JSON object, a model still sometimes wraps the whole answer in
 * a Markdown code block; only a complete wrapper is taken off, nothing in the answer is changed.
 */
export function modelJson(content: string, message: string): unknown {
  const plain = content.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/i, '$1');
  try { return JSON.parse(plain); } catch { throw new Error(message); }
}
