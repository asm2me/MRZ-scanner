import { parseText } from "./parseText.js";
export function parseOptional(source) {
    const value = parseText(source, 0);
    return {
        value,
        start: 0,
        end: value.length,
    };
}
//# sourceMappingURL=parseOptional.js.map