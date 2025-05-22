# videochat

## Description
This is a very basic implementation of a one video call web app using goriila websockets and Webrtc it makes uses of rooms and client ids


## Usage
You could run this locally or on online using a host of your choice I chose render for this
to run locally 
go mod tidy && go run main.go
if youd'd like to run on render sign up with your repo provider e.g github or gitlab and use this as the build command
go mod tidy && go build -tags netgo -ldflags '-s -w' -o app
use this as the run command
./app
you could choose to specify the port
## Contribution
If you'd like to contribute to this repo please create a pull request with your additions

