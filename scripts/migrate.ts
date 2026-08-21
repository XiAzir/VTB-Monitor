import { closeDb, getDb } from '../src/lib/server/db';

getDb();
closeDb();
console.log('Database migrations are up to date.');
