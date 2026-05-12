module example.com/myapp

go 1.21

toolchain go1.21.5

require (
	github.com/gin-gonic/gin v1.9.1
	github.com/stretchr/testify v1.8.4
)

require golang.org/x/crypto v0.21.0 // indirect

replace github.com/gin-gonic/gin => github.com/gin-gonic/gin v1.9.0

exclude github.com/stretchr/testify v1.8.0

retract v0.0.1 // accidental release
