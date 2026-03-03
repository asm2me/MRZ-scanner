export function cleanText(string) {
    return string.replaceAll(/<+$/g, '').replaceAll('<', ' ');
}
//# sourceMappingURL=cleanText.js.map