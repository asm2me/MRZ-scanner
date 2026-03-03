import { formats } from "../formats.js";
import { getResult } from "./getResult.js";
import TD3Fields from "./td3Fields.js";
const TD3 = formats.TD3;
export default function parseTD3(lines, options) {
    if (lines.length !== 2) {
        throw new Error(`invalid number of lines: ${lines.length}: Must be 2 for ${TD3}`);
    }
    for (const [index, line] of lines.entries()) {
        if (line.length !== 44) {
            throw new Error(`invalid number of characters for line ${index + 1}: ${line.length}. Must be 44 for TD3`);
        }
    }
    return getResult(TD3, lines, TD3Fields, options);
}
//# sourceMappingURL=td3.js.map