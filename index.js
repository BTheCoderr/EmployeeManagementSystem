const express = require("express")
const app = express()
const mysql = require("mysql")
const bodyParser = require('body-parser')

require("dotenv").config()
const PORT = process.env.PORT

const connection = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  tableName: process.env.DB_TABLE_NAME
})

connection.connect((err) => {
  if (err) throw err
  console.log("Connected to MySQL Server!")
})

app.set("view engine", "ejs")
app.use(bodyParser.urlencoded({ extended: true }))

app.get("/", function (req, res) {
  res.render("pages/index")
})

app.post("/addemployee", function (req, res) {

  const { FirstName, LastName, Department, JobTitle, StartDate, EndDate, Salary } = req.body
  const endEndDate = EndDate.trim() ? EndDate : null

  connection.query(
    `INSERT INTO ${process.env.DB_TABLE_NAME} SET ?`,
    { FirstName, LastName, Department, JobTitle, StartDate, EndDate: endEndDate, Salary },
    (err) => {
      if (err) {
        console.error("Error inserting employee into the database:", err)
        return res.status(500).send("Error inserting employee into the database")
      }
      console.log("1 record inserted")
      res.render("addemployeesuccess", { firstName: FirstName, lastName: LastName })
    }
  )
})

app.listen(PORT, () => {
  console.log(`Node.js server running at http://localhost:${PORT}`)
  console.log(`Add employee form at http://localhost:${PORT}`)
})
