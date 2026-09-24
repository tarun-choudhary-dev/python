/** The complete, intentionally small package surface exposed by PYLAB. */
export const PYTHON_PACKAGES = Object.freeze([
  { id: 'numpy', label: 'NumPy', runtimeName: 'numpy', importName: 'numpy' },
  { id: 'pandas', label: 'Pandas', runtimeName: 'pandas', importName: 'pandas' },
  { id: 'matplotlib', label: 'Matplotlib', runtimeName: 'matplotlib', importName: 'matplotlib' },
  { id: 'scipy', label: 'SciPy', runtimeName: 'scipy', importName: 'scipy' },
  { id: 'sympy', label: 'SymPy', runtimeName: 'sympy', importName: 'sympy' },
  { id: 'scikit-learn', label: 'Scikit-learn', runtimeName: 'scikit-learn', importName: 'sklearn' },
  { id: 'networkx', label: 'NetworkX', runtimeName: 'networkx', importName: 'networkx' },
  { id: 'beautifulsoup4', label: 'BeautifulSoup4', runtimeName: 'beautifulsoup4', importName: 'bs4' },
  { id: 'pillow', label: 'Pillow', runtimeName: 'pillow', importName: 'PIL' },
].map(entry => Object.freeze(entry)));

export const PACKAGE_BY_ID = new Map(PYTHON_PACKAGES.map(entry => [entry.id, entry]));
export const PACKAGE_BY_RUNTIME_NAME = new Map(PYTHON_PACKAGES.map(entry => [entry.runtimeName, entry]));
