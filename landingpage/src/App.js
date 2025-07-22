import { BrowserRouter, Routes, Route } from 'react-router-dom';
import MealPlanViewer from './MealPlanViewer';
console.log("🔥 Running NEW version deployed on July 17 🔥");


function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/meal-plan" element={<MealPlanViewer />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
