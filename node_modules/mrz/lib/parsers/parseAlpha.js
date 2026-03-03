import { cleanText } from "./cleanText.js";
export function parseAlpha(source) {
    if (!source.match(/^[A-Z<]+$/)) {
        throw new Error(`invalid text: ${source}. Must be only alphabetical with <`);
    }
    return cleanText(source);
}
//# sourceMappingURL=parseAlpha.js.map