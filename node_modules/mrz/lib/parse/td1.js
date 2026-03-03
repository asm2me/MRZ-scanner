import { formats } from "../formats.js";
import { getResult } from "./getResult.js";
import TD1Fields from "./td1Fields.js";
const TD1 = formats.TD1;
export default function parseTD1(lines, options) {
    if (lines.length !== 3) {
        throw new Error(`invalid number of lines: ${lines.length}: Must be 3 for ${TD1}`);
    }
    for (const [index, line] of lines.entries()) {
        if (line.length !== 30) {
            throw new Error(`invalid number of characters for line ${index + 1}: ${line.length}. Must be 30 for ${TD1}`);
        }
    }
    return getResult(TD1, lines, TD1Fields, options);
}
//# sourceMappingURL=td1.js.map