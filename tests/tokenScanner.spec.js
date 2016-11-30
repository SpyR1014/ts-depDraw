var chai = require("chai");
var sinon = require("sinon");
var expect = chai.expect;

var tkScanner = require("../lib/tokenScanner");


describe("Single File Scan", function(){
    it("Small file scan", function(done){
        tkScanner.scanFile("tests/examples/ex1.ts", (err, response)=>{
            console.log('I HAVE RESPONSE:', response);
            done();
        });
        expect(2).to.eq(1);
    });
});