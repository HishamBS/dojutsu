// R05: eval usage
export function processInput(code: string) {
  return eval(code);
}

// R07: explicit any
export function handleData(data: any): any {
  return data;
}

// R12: hardcoded localhost
const API_URL = "http://localhost:8080/api";

// R13: magic number
export function getTimeout() {
  return 30000;
}
