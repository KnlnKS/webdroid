/** Java character-class unions/intersections expressed as JavaScript Unicode sets. */
export function javaClassSets(source: string): string {
  let i = 0;
  function scan(inClass: boolean): string {
    const parts = [""];
    let negative = "";
    if (inClass && source[i] === "^") { negative = "^"; i++; }
    while (i < source.length) {
      const ch = source[i++];
      let text = ch;
      if (ch === "\\") {
        if (i === source.length) throw new SyntaxError("Trailing regex escape");
        const next = source[i++];
        const escaped = inClass ? "()[]{}\\/|-^$.*+?&!#%,:;<=>@`~" : "^$\\.*+?()[]{}|/";
        text = /[A-Za-z0-9]/.test(next) || escaped.includes(next) ? ch + next : next;
      } else if (ch === "[") text = scan(true);
      else if (inClass && ch === "]") {
        return `[${negative}${parts.length === 1 ? parts[0] : parts.map((part) => `[${part}]`).join("&&")}]`;
      } else if (inClass && ch === "&" && source[i] === "&") {
        i++; parts.push(""); continue;
      } else if (inClass && "(){}\\/|^".includes(ch)) text = "\\" + ch;
      else if (inClass && ch === "-" && (!parts[parts.length - 1] || source[i] === "]")) text = "\\-";
      parts[parts.length - 1] += text;
    }
    if (inClass) throw new SyntaxError("Unclosed regex character class");
    return parts.join("");
  }
  return scan(false);
}
