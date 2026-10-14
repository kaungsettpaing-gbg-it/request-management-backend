async function testFullSystem() {
  try {
    console.log("1. Creating User...");
    const userRes = await fetch('http://localhost:5000/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: "Mg Mg",
        email: "mgmg" + Date.now() + "@example.com", 
        password: "password123"
      })
    });
    const userData = await userRes.json();
    console.log("User Created:", userData);
    const userId = userData.user.id;

    console.log("\n2. Creating Request...");
    const reqRes = await fetch('http://localhost:5000/api/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: "Leave Request",
        description: "Need 1 day off for family matter.",
        userId: userId
      })
    });
    const reqData = await reqRes.json();
    console.log("Request Created:", reqData);
    const requestId = reqData.request.id;

    console.log("\n3. Getting All Requests...");
    const getRes = await fetch('http://localhost:5000/api/requests');
    const getAllData = await getRes.json();
    console.log("All Requests:", JSON.stringify(getAllData, null, 2));

    console.log("\n4. Updating Request Status (APPROVE)...");
    const updateRes = await fetch(`http://localhost:5000/api/requests/${requestId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: "APPROVED" })
    });
    const updateData = await updateRes.json();
    console.log("Updated Request:", updateData);

    console.log("\n✨ System Test Completed Successfully!");
  } catch (error) {
    console.error("Error:", error);
  }
}

testFullSystem();