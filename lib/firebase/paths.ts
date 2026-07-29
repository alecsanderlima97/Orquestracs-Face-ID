export function companyPath(companyId: string) {
  return `companies/${companyId}`;
}

export function companyLogoPath(companyId: string, extension = "webp") {
  return `companies/${companyId}/profile/logo.${extension}`;
}

export function employeePath(companyId: string, employeeId: string) {
  return `companies/${companyId}/employees/${employeeId}`;
}

export function facePhotoPath(companyId: string, employeeId: string, photoId: string) {
  return `companies/${companyId}/employees/${employeeId}/face-id/${photoId}.webp`;
}

export function punchPhotoPath(
  companyId: string,
  employeeId: string,
  date: string,
  punchId: string,
) {
  return `companies/${companyId}/employees/${employeeId}/punches/${date}/${punchId}.webp`;
}

export function reportPath(companyId: string, reportId: string) {
  return `companies/${companyId}/reports/${reportId}.pdf`;
}
