const express = require("express")
const app = express()
const mysql = require("mysql")
const bodyParser = require('body-parser')
const session = require('express-session')

// dotenv
require("dotenv").config()
const PORT = process.env.PORT || 3000

const connection = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
})

connection.connect((err) => {
  if (err) throw err
  console.log("Connected to MySQL Server!")
})

app.set("view engine", "ejs")

// Body parser middleware
app.use(bodyParser.urlencoded({ extended: true }))

// Serve static files
app.use(express.static(__dirname + '/views/pages'))

// Session middleware
app.use(session({
  secret: 'yourSecretKey',
  resave: false,
  saveUninitialized: true
}))

// Middleware to check if user is logged in
function checkAuth(req, res, next) {
  if (req.session.loggedIn) {
    next()
  } else {
    res.redirect('/mysqllogin')
  }
}

// Routes
app.get("/", function (req, res) {
  res.render("pages/index") // Main page
})

app.get("/mysqllogin", function (req, res) {
  res.render("pages/mysqllogin")
})

app.post("/mysqllogin", function (req, res) {
  const { username, password } = req.body
  connection.query(
    'SELECT * FROM employees WHERE username = ? AND password = ?',
    [username, password],
    (err, results) => {
      if (err) {
        console.error("Error querying the database:", err)
        return res.status(500).send("Error querying the database")
      }
      if (results.length > 0) {
        req.session.loggedIn = true
        req.session.username = username
        res.render("pages/loginSuccess", { username: username })
      } else {
        res.send("Invalid username or password")
      }
    }
  )
})

app.get("/form2database", checkAuth, function (req, res) {
  res.render("pages/form2database")
})

app.post("/addemployee", checkAuth, function (req, res) {
  const { FirstName, LastName, Department, JobTitle, StartDate, EndDate, Salary, username, password } = req.body

  const endEndDate = EndDate.trim() ? EndDate : null

  connection.query(
    `INSERT INTO employees (FirstName, LastName, Department, JobTitle, StartDate, EndDate, Salary, username, password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [FirstName, LastName, Department, JobTitle, StartDate, endEndDate, Salary, username, password],
    (err) => {
      if (err) {
        console.error("Error inserting employee into the database:", err)
        return res.status(500).send("Error inserting employee into the database")
      }
      console.log("1 record inserted")
      res.render("pages/addemployee", { firstName: FirstName, lastName: LastName })
    }
  )
})

app.get("/employees", checkAuth, (req, res) => {
  connection.query('SELECT * FROM employees', (err, results) => {
    if (err) {
      console.error("Error fetching employees from the database:", err)
      return res.status(500).send("Error fetching employees from the database")
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
