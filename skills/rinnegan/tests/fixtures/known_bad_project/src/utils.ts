// R09: console.log
export function debug(msg: string) {
  console.log("DEBUG:", msg);
}

// R14: TODO marker
// TODO: implement proper validation
export function validate(input: string): boolean {
  return input.length > 0;
}

// R13: magic number in setTimeout
export function retry(fn: () => void) {
  setTimeout(fn, 5000);
}
