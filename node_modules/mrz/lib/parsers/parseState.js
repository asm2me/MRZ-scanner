import STATES from "../generated/states.js";
import { cleanText } from "./cleanText.js";
export default function parseState(source) {
    source = cleanText(source);
    const state = STATES[source];
    if (!state) {
        throw new Error(`invalid state code: ${source}`);
    }
    return {
        value: source,
        start: 0,
        end: source.length,
    };
}
//# sourceMappingURL=parseState.js.map