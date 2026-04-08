#!/usr/bin/env python3
"""Usage: create-inventory.py <project_dir> <audit_dir>
Walks file tree, counts LOC, classifies layers, writes inventory.json.
Deterministic — no LLM needed. Runs in <2 seconds on 1000+ files."""
import os, json, sys

project_dir = sys.argv[1]
audit_dir = sys.argv[2]

LAYER_PATTERNS = {
    'api-routes': ['app/api/', 'pages/api/', 'src/app/api/'],
    'routes': ['routes/', 'src/routes/'],
    'components': ['components/', 'src/components/'],
    'modules': ['modules/', 'src/modules/'],
    'hooks': ['hooks/', 'src/hooks/'],
    'services': ['services/', 'src/services/'],
    'types': ['types/', 'src/types/', '@types/'],
    'config': ['config/', 'configs/', 'constants/', 'src/config/'],
    'stores': ['store/', 'stores/', 'zustand/'],
    'utils': ['utils/', 'lib/', 'helpers/', 'common/', 'shared/'],
    'providers': ['providers/', 'contexts/', 'src/providers/'],
    'infrastructure': ['Dockerfile', 'docker-compose', '.github/', '.gitlab-ci'],
    'tests': ['__tests__/', 'test/', 'spec/', '.test.', '.spec.'],
}

# Stack-specific layer patterns (applied when stack is detected)
JAVA_LAYER_PATTERNS = {
    'controllers': ['controller.java', '/controller/', '/controllers/', '/rest/', '/web/'],
    'services': ['service.java', '/service/', '/services/'],
    'repositories': ['repository.java', '/repository/', '/repositories/', '/dao/'],
    'dto': ['/dto/', 'dto.java', 'request.java', 'response.java', 'requestdto.java', 'responsedto.java'],
    'entities': ['/entity/', '/entities/', '/model/', '/domain/'],
    'config': ['config.java', 'configuration.java', '/config/', '/configuration/'],
    'mappers': ['mapper.java', '/mapper/', '/mappers/', '/converter/'],
    'utils': ['/util/', '/utils/', '/helper/', '/common/'],
    'tests': ['/test/', 'test.java', 'tests.java', '/it/', 'integrationtest'],
}

PYTHON_LAYER_PATTERNS = {
    'routes': ['/routes/', '/endpoints/', '/views/', '/routers/'],
    'services': ['/services/', '/service/'],
    'models': ['/models/', '/schemas/', '/entities/'],
    'utils': ['/utils/', '/helpers/', '/common/', '/shared/'],
    'config': ['/config/', '/configs/', '/settings/', 'settings.py', 'config.py'],
    'tests': ['/tests/', '/test/', 'test_', '_test.py', 'conftest.py'],
    'middleware': ['/middleware/', '/middlewares/'],
    'agents': ['/agents/', '/tools/', '/prompts/'],
}

GO_LAYER_PATTERNS = {
    'cmd': ['/cmd/'],
    'internal': ['/internal/'],
    'pkg': ['/pkg/'],
    'handlers': ['/handler/', '/handlers/'],
    'services': ['/service/', '/services/'],
    'models': ['/model/', '/models/'],
    'middleware': ['/middleware/'],
    'utils': ['/util/', '/utils/', '/pkg/util'],
    'tests': ['_test.go'],
}

SKIP_DIRS = {'node_modules', '.next', '__pycache__', '.git', 'dist', 'build',
             '.venv', 'venv', '.turbo', '.cache', 'coverage', '.nyc_output'}

EXTENSIONS = {
    'typescript': {'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'},
    'python': {'.py'},
    'java': {'.java', '.kt', '.kts'},
    'go': {'.go'},
    'rust': {'.rs'},
}

# Auto-detect stack
stack = 'unknown'
framework = 'unknown'
if os.path.exists(os.path.join(project_dir, 'package.json')):
    stack = 'typescript'
    try:
        pkg = json.load(open(os.path.join(project_dir, 'package.json')))
        deps = {**pkg.get('dependencies', {}), **pkg.get('devDependencies', {})}
        if 'next' in deps: framework = 'nextjs'
        elif 'react' in deps: framework = 'react'
        elif 'vue' in deps: framework = 'vue'
        elif 'express' in deps: framework = 'express'
    except: pass
elif os.path.exists(os.path.join(project_dir, 'pyproject.toml')) or os.path.exists(os.path.join(project_dir, 'requirements.txt')):
    stack = 'python'
    if os.path.exists(os.path.join(project_dir, 'pyproject.toml')):
        try:
            content = open(os.path.join(project_dir, 'pyproject.toml')).read()
            if 'fastapi' in content.lower(): framework = 'fastapi'
            elif 'django' in content.lower(): framework = 'django'
            elif 'flask' in content.lower(): framework = 'flask'
        except: pass
elif os.path.exists(os.path.join(project_dir, 'pom.xml')) or os.path.exists(os.path.join(project_dir, 'build.gradle')):
    stack = 'java'

exts = EXTENSIONS.get(stack, {'.ts', '.tsx', '.py', '.java'})

# Walk files
files = []
total_loc = 0
layers = {}

for root, dirs, filenames in os.walk(project_dir):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
    for fname in filenames:
        if not any(fname.endswith(ext) for ext in exts):
            continue
        fpath = os.path.join(root, fname)
        rel_path = os.path.relpath(fpath, project_dir)
        try:
            with open(fpath, 'r', errors='ignore') as f:
                loc = sum(1 for _ in f)
        except:
            loc = 0

        # Classify layer — try stack-specific patterns first, then generic
        layer = 'misc'
        rel_lower = rel_path.lower().replace('\\', '/')
        stack_patterns = {
            'java': JAVA_LAYER_PATTERNS,
            'python': PYTHON_LAYER_PATTERNS,
            'go': GO_LAYER_PATTERNS,
        }.get(stack, {})
        # Stack-specific patterns take priority
        for layer_name, patterns in stack_patterns.items():
            if any(p in rel_lower for p in patterns):
                layer = layer_name
                break
        # Fall back to generic patterns if still misc
        if layer == 'misc':
            for layer_name, patterns in LAYER_PATTERNS.items():
                if any(p in rel_lower for p in patterns):
                    layer = layer_name
                    break

        # Tag
        tag = 'SOURCE'
        if any(p in rel_lower for p in ['__tests__/', '.test.', '.spec.', '/test/', '/tests/']):
            tag = 'TEST'
        elif any(p in rel_lower for p in ['generated/', 'auto-generated']):
            tag = 'GENERATED'

        files.append({"path": rel_path, "loc": loc, "layer": layer, "tag": tag})
        total_loc += loc
        if layer not in layers:
            layers[layer] = {"files": [], "loc": 0}
        layers[layer]["files"].append(rel_path)
        layers[layer]["loc"] += loc

# Create output directories
os.makedirs(f"{audit_dir}/data/scanner-output", exist_ok=True)
os.makedirs(f"{audit_dir}/data/tasks", exist_ok=True)
os.makedirs(f"{audit_dir}/layers", exist_ok=True)
os.makedirs(f"{audit_dir}/phases", exist_ok=True)

# Write inventory
inventory = {
    "root": os.path.basename(project_dir),
    "stack": stack,
    "framework": framework,
    "total_files": len(files),
    "total_loc": total_loc,
    "layers": layers,
    "files": files
}
json.dump(inventory, open(f"{audit_dir}/data/inventory.json", "w"), indent=2)

# Write empty scope-map
json.dump({}, open(f"{audit_dir}/data/scanner-output/scope-map.json", "w"))

print(f"Stack: {stack}/{framework}")
print(f"Files: {len(files)}, LOC: {total_loc}, Layers: {len(layers)}")
for name, data in sorted(layers.items(), key=lambda x: -x[1]['loc']):
    print(f"  {name}: {len(data['files'])} files, {data['loc']} LOC")
print(f"Output: {audit_dir}/data/inventory.json")
print(f"Directories created: {audit_dir}/{{data,layers,phases}}")
