/**
 * Convert YYYYMMDD format string to Date object
 * @param dateStr - Date string in YYYYMMDD format (e.g., "20250215")
 * @returns Date object
 */
export const yyyymmddToDate = (dateStr: string): Date => {
  if (!/^\d{8}$/.test(dateStr)) {
    throw new Error(`Invalid date format. Expected YYYYMMDD, got: ${dateStr}`);
  }
  
  const year = parseInt(dateStr.substring(0, 4), 10);
  const month = parseInt(dateStr.substring(4, 6), 10) - 1; // Month is 0-indexed
  const day = parseInt(dateStr.substring(6, 8), 10);
  
  return new Date(year, month, day);
};

/**
 * Convert Date object to YYYYMMDD format string
 * @param date - Date object
 * @returns Date string in YYYYMMDD format (e.g., "20250215")
 */
export const dateToYyyymmdd = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  
  return `${year}${month}${day}`;
};

/**
 * Get today's date in YYYYMMDD format
 * @returns Today's date in YYYYMMDD format
 */
export const getTodayYyyymmdd = (): string => {
  return dateToYyyymmdd(new Date());
};

/**
 * Add days to a YYYYMMDD date string
 * @param dateStr - Date string in YYYYMMDD format
 * @param days - Number of days to add
 * @returns Date string in YYYYMMDD format
 */
export const addDaysToYyyymmdd = (dateStr: string, days: number): string => {
  const date = yyyymmddToDate(dateStr);
  date.setDate(date.getDate() + days);
  return dateToYyyymmdd(date);
};

/**
 * Compare two YYYYMMDD date strings
 * @param date1 - First date in YYYYMMDD format
 * @param date2 - Second date in YYYYMMDD format
 * @returns Negative if date1 < date2, 0 if equal, positive if date1 > date2
 */
export const compareYyyymmdd = (date1: string, date2: string): number => {
  return date1.localeCompare(date2);
};
