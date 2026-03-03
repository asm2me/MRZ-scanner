import parseFrenchDrivingLicense from "./frenchDrivingLicence.js";
import parseFrenchNationalId from "./frenchNationalId.js";
import parseSwissDrivingLicense from "./swissDrivingLicense.js";
import parseTD1 from "./td1.js";
import parseTD2 from "./td2.js";
import parseTD3 from "./td3.js";
export const parsers = {
    td1: parseTD1,
    td2: parseTD2,
    td3: parseTD3,
    swissDrivingLicense: parseSwissDrivingLicense,
    frenchNationalId: parseFrenchNationalId,
    frenchDrivingLicense: parseFrenchDrivingLicense,
};
//# sourceMappingURL=parsers.js.map