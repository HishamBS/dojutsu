import httpx
import os

# R05: verify=False
def fetch_data(url: str):
    with httpx.Client(verify=False) as client:
        return client.get(url)

# R12: hardcoded URL
BASE_URL = "http://localhost:3000"

# R09: print statement
def debug_config():
    print("Config loaded")
