# videochat

## Description
 This is a very basic implementation of a one to one video call web app using gorrila websockets and the WebRTC api, it makes use of rooms and client ids to automatically connect random peers connected to the signaling server, here is the link to see how it looks live: https://videochat-k8rf.onrender.com. Once you're on the site no need for registration just press call and hopefuly someone who's also connected might answer,might be me lol :)


## Usage
 You could run this locally or on online using a host of your choice I chose render for this ,to run locally 

 `go mod tidy && go run main.go `

 if you would  like to run on render sign up with your repo provider e.g github or gitlab and use this as the build command

 `go mod tidy && go build -tags netgo -ldflags '-s -w' -o app`

 use this as the run command
 `./app`

 you could choose to specify the port

 I advice getting your turn server credentials from `https://dashboard.metered.ca/` and intialize the ICE servers in the main.js file at the top 

 `const servers=[]`

 I dont know much about javascript so the javascript code is gpt modified boilerplate code from fireship repo

## Contribution
# If you'd like to contribute to this repo please create a pull request with your additions

## Roadmap
I'll be looking towards advancing this project soon enough ,i'll also use this for a full scale web service and  build a mobile and desktop application around it ,this will also be the first project i'll be discussing in detail in my upcoming and long awaited blog
