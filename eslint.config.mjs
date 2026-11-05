import { globalIgnores } from 'eslint/config';
import { neostandard } from 'neostandard';

export default [
  globalIgnores(['dist', 'coverage', 'hypjson.js']),
  ...neostandard({ ts: true, semi: true, noJsx: true, env: ['browser', 'node'] })
];
