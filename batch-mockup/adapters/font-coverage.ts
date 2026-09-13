/** TrueType Unicode cmap validation prevents silent .notdef / unrelated system-font substitution. */
export function missingGlyphs(font: Buffer, text: string): string[] {
    const tables = font.readUInt16BE(4);
    let cmap = -1;
    for (let i = 0; i < tables; i++) {
        const p = 12 + i * 16;
        if (font.toString('ascii', p, p + 4) === 'cmap')
            cmap = font.readUInt32BE(p + 8);
    }
    if (cmap < 0)
        throw new Error('字体缺少 cmap');
    const subtables: number[] = [];
    for (let i = 0; i < font.readUInt16BE(cmap + 2); i++) {
        const p = cmap + 4 + i * 8, platform = font.readUInt16BE(p), encoding = font.readUInt16BE(p + 2);
        if (platform === 0 || platform === 3 && [1, 10].includes(encoding))
            subtables.push(cmap + font.readUInt32BE(p + 4));
    }
    function has(cp: number) {
        for (const off of subtables) {
            const format = font.readUInt16BE(off);
            if (format === 12) {
                const groups = font.readUInt32BE(off + 12);
                let lo = 0, hi = groups - 1;
                while (lo <= hi) {
                    const mid = (lo + hi) >> 1, p = off + 16 + mid * 12, start = font.readUInt32BE(p), end = font.readUInt32BE(p + 4);
                    if (cp < start)
                        hi = mid - 1;
                    else if (cp > end)
                        lo = mid + 1;
                    else
                        return font.readUInt32BE(p + 8) + (cp - start) !== 0;
                }
            }
            if (format === 4 && cp <= 65535) {
                const count = font.readUInt16BE(off + 6) / 2, end = off + 14, start = end + count * 2 + 2, delta = start + count * 2, range = delta + count * 2;
                for (let i = 0; i < count; i++) {
                    if (cp < font.readUInt16BE(start + i * 2) || cp > font.readUInt16BE(end + i * 2))
                        continue;
                    const d = font.readInt16BE(delta + i * 2), r = font.readUInt16BE(range + i * 2);
                    if (!r)
                        return ((cp + d) & 65535) !== 0;
                    const p = range + i * 2 + r + 2 * (cp - font.readUInt16BE(start + i * 2));
                    if (p + 2 > font.length)
                        return false;
                    const glyph = font.readUInt16BE(p);
                    return glyph !== 0 && ((glyph + d) & 65535) !== 0;
                }
            }
        }
        return false;
    }
    return [...new Set([...text].filter(c => c !== '\n' && !has(c.codePointAt(0)!)))];
}
