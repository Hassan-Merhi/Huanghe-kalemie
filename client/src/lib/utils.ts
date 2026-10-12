import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Format a number with comma separators and proper decimals
 * Examples: 1234567.00 -> "1,234,567", 5.50 -> "5.5", 5.25 -> "5.25"
 */
export function formatNumber(value: number | string | null | undefined, decimals: number = 2): string {
  if (value === null || value === undefined || value === "") return "0";
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "0";
  
  // Format with commas and specified decimals
  const formatted = num.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
  
  return formatted;
}

/**
 * Format a currency value, removing unnecessary .00 decimals
 * Examples: 5.00 -> "$5", 5.50 -> "$5.5", 5.25 -> "$5.25"
 */
export function formatCurrency(value: number | string | null | undefined, decimals: number = 2): string {
  if (value === null || value === undefined || value === "") return "$0";
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "$0";
  
  const isNegative = num < 0;
  const absNum = Math.abs(num);
  const formatted = formatNumber(absNum, decimals);
  
  return isNegative ? `-$${formatted}` : `$${formatted}`;
}
