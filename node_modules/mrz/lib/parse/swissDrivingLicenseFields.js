import { parseNumber } from "../parsers/parseNumber.js";
import { checkSeparator } from "../parsers/swissDrivingLicense/checkSeparator.js";
import parseDocumentCode from "../parsers/swissDrivingLicense/parseDocumentCode.js";
import parseDocumentNumber from "../parsers/swissDrivingLicense/parseDocumentNumber.js";
import parseIssuingState from "../parsers/swissDrivingLicense/parseIssuingState.js";
import parseLanguageCode from "../parsers/swissDrivingLicense/parseLanguageCode.js";
import createFieldParser, { fieldTypes } from "./createFieldParser.js";
import { birthDateTemplate, documentCodeTemplate, documentNumberTemplate, firstNameTemplate, issuingStateTemplate, lastNameTemplate, } from "./fieldTemplates.js";
const fields = [
    {
        ...documentNumberTemplate,
        line: 0,
        start: 0,
        end: 9,
        parser: parseDocumentNumber,
    },
    {
        label: 'Language code',
        field: 'languageCode',
        line: 0,
        start: 6,
        end: 7,
        parser: parseLanguageCode,
        type: fieldTypes.ALPHABETIC,
    },
    {
        ...documentCodeTemplate,
        line: 1,
        start: 0,
        end: 2,
        parser: parseDocumentCode,
    },
    {
        ...issuingStateTemplate,
        line: 1,
        start: 2,
        end: 5,
        parser: parseIssuingState,
    },
    {
        label: 'PIN code',
        field: 'pinCode',
        line: 1,
        start: 5,
        end: 14,
        parser: parseNumber,
        type: fieldTypes.NUMERIC,
    },
    {
        label: 'Version number',
        field: 'versionNumber',
        line: 1,
        start: 14,
        end: 17,
        parser: parseNumber,
        type: fieldTypes.NUMERIC,
    },
    {
        label: 'Separator 1',
        field: null,
        line: 1,
        start: 17,
        end: 19,
        parser: checkSeparator,
    },
    { ...birthDateTemplate, line: 1, start: 19, end: 25 },
    {
        label: 'Separator 2',
        field: null,
        line: 1,
        start: 25,
        end: 30,
        parser: checkSeparator,
    },
    { ...lastNameTemplate, line: 2, start: 0, end: 30 },
    { ...firstNameTemplate, line: 2, start: 0, end: 30 },
];
export default fields.map(createFieldParser);
//# sourceMappingURL=swissDrivingLicenseFields.js.map