import postgres from 'postgres'
import dotenv from 'dotenv'

dotenv.config()

const connectionString = process.env.DATABASE_URL_ADMIN || process.env.DATABASE_URL

if (!connectionString) {
  throw new Error('DATABASE_URL_ADMIN/DATABASE_URL is not defined in .env file')
}

const sqlAdmin = postgres(connectionString, {
  prepare: false,
})

export default sqlAdmin
