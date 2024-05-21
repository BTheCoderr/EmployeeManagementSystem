const express = require("express")
const app = express()
const mysql = require("mysql")
const bodyParser = require('body-parser')
const session = require('express-session')
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
app.use(session({
  secret: 'yourSecretKey',
  resave: false,
  saveUninitialized: true
}))

function checkAuth(req, res, next) {
  if (req.session.loggedIn) {
    next()
  } else {
    res.redirect('/mysqllogin')
  }
}

app.get("/", function (req, res) {
  res.render("pages/index")
})

app.get("/form2database", checkAuth, function (req, res) {
  res.render("pages/form2database")
})

app.post("/addemployee", checkAuth, function (req, res) {
  const { FirstName, LastName, Department, JobTitle, StartDate, EndDate, Salary, username, password } = req.body
  const endEndDate = EndDate.trim() ? EndDate : null

  connection.query(
    `SELECT * FROM ${process.env.DB_TABLE_NAME} WHERE FirstName = ? AND LastName = ? AND Department = ?`,
    [FirstName, LastName, Department],
    (err, results) => {
      if (err) {
        console.error("Error querying the database:", err)
        return res.status(500).send("Error querying the database")
      }

      if (results.length > 0) {
        return res.send("Employee with the same name in the same department already exists")
      } else {
        connection.query(
          `INSERT INTO ${process.env.DB_TABLE_NAME} SET ?`,
          { FirstName, LastName, Department, JobTitle, StartDate, EndDate: endEndDate, Salary, username },
          (err) => {
            if (err) {
              console.error("Error inserting employee into the database:", err)
              return res.status(500).send("Error inserting employee into the database")
            }
            console.log("1 record inserted")
            res.render("pages/addemployeesuccess", { firstName: FirstName, lastName: LastName })
          }
        )
      }
    }
  )
})

app.get("/mysqllogin", function (req, res) {
  res.render("pages/mysqllogin")
})

app.post("/mysqllogin", function (req, res) {
  const { username, password } = req.body
  connection.query(
    'SELECT * FROM users WHERE username = ? AND password = ?',
    [username, password],
    (err, results) => {
      if (err) {
        console.error("Error querying the database:", err)
        return res.status(500).send("Error querying the database")
      }

      if (results.length > 0) {
        req.session.loggedIn = true
        req.session.username = username
        res.redirect("/form2database")
      } else {
        res.render("pages/incorrectpassword")
      }
    }
  )
})

app.get("/employees", checkAuth, function (req, res) {
  connection.query('SELECT * FROM employees', (err, results) => {
    if (err) {
      console.error("Error fetching employees:", err)
      return res.status(500).send("Error fetching employees")
    }
    res.render("pages/employees", { employees: results })
  })
})

app.listen(PORT, () => {
  console.log(`Node.js server running at http://localhost:${PORT}`)
  console.log(`Login at http://localhost:${PORT}/mysqllogin`)
  console.log(`Add employee form at http://localhost:${PORT}/form2database`)
  console.log(`View employees at http://localhost:${PORT}/employees`)
})
